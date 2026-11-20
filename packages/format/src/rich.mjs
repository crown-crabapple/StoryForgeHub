// Scene body Markdown <-> rich document (schema v1, ProseMirror JSON shape), for the chapter editor (Phase 2, docs/plans/phase2/design.md).
//
// Two promises, both tested:
//   1. Lossless read:  docToMarkdown(markdownToDoc(b).doc) === b for EVERY string b. Whatever the schema cannot reproduce byte for byte becomes a
//      rawBlock / rawInline node that holds the exact text.
//   2. Stable write:   docToMarkdown(d) parses its own output again and throws RichSerializeError unless that gives the same document. A caller must
//      never save when it throws.
// Pure: no I/O, no dependencies, runs in the browser and in Node.

export const RICH_SCHEMA_VERSION = 1;

/** docToMarkdown could not write this document without changing its meaning. Nothing should be saved. */
export class RichSerializeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RichSerializeError';
  }
}

const DEFAULT_GAP = '\n\n';
const BLANK = /^[ \t]*$/;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '~', '[', ']', '<', '>', '#', '+', '-', '.', '!', '(', ')', '|']);
const INLINE_SPECIAL = new Set(['\\', '`', '*', '_', '~', '[', ']', '<', '!']);
const MARK_RANK = { link: 0, bold: 1, italic: 2, strike: 3, code: 4 };
const MARK_DEFAULTS = { bold: { delim: '**' }, italic: { delim: '*' }, strike: {}, code: {}, link: { href: '' }, entityMention: { slug: '', form: 'bare', state: 'confirmed' } };
const NODE_DEFAULTS = {
  heading: { level: 2 },
  bulletList: { marker: '-' },
  orderedList: { start: 1, delim: '.' },
  hardBreak: { soft: true },
  authorNote: { text: '' },
  cite: { key: '' },
  rawInline: { text: '' },
  rawBlock: { text: '' },
};
const isAlnum = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

// ------------------------------------------------------------------------------------------------------------------------------ read

/**
 * @param {string} body the scene body (the text after the front matter)
 * @returns {{ doc: any, report: { blocks: number, rawBlocks: number, rawInlines: number, authorNotes: number, cites: number, mentions: number, mixedEol: boolean } }}
 */
export function markdownToDoc(body) {
  const report = { blocks: 0, rawBlocks: 0, rawInlines: 0, authorNotes: 0, cites: 0, mentions: 0, mixedEol: false };
  const crlf = body.includes('\r\n');
  const lone = crlf ? /\r(?!\n)|(?<!\r)\n/.test(body) : body.includes('\r');
  if (lone) {
    report.mixedEol = true;
    report.rawBlocks = 1;
    return { doc: { type: 'doc', attrs: { lead: '', trail: '', eol: 'lf', readOnly: true }, content: [{ type: 'rawBlock', attrs: { text: body } }] }, report };
  }
  const text = crlf ? body.replaceAll('\r\n', '\n') : body;
  const { lead, trail, chunks } = splitChunks(text);
  const content = [];
  for (const [i, c] of chunks.entries()) {
    const block = parseChunk(c.text);
    if (i > 0) block.attrs = { ...block.attrs, gap: c.gap };
    content.push(block);
  }
  const doc = { type: 'doc', attrs: { lead, trail, eol: crlf ? 'crlf' : 'lf' }, content };
  count(doc, report);
  return { doc, report };
}

/** Blocks are runs of non-blank lines; a fenced code block or an open HTML comment keeps going across blank lines. */
function splitChunks(text) {
  const lines = text.split('\n');
  const starts = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const chunks = [];
  let i = 0;
  let lastEnd = 0;
  let lead = null;
  while (i < lines.length) {
    if (BLANK.test(lines[i])) {
      i++;
      continue;
    }
    const begin = i;
    let fence = null;
    let comments = 0;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (i > begin && fence === null && comments === 0 && BLANK.test(l)) break;
      const f = /^(```|~~~)/.exec(l);
      if (f && comments === 0) {
        if (fence === null) fence = f[1];
        else if (l.startsWith(fence) && i > begin) fence = null;
      }
      if (fence === null) comments = Math.max(0, comments + (l.split('<!--').length - 1) - (l.split('-->').length - 1));
    }
    const from = starts[begin];
    const to = starts[i - 1] + lines[i - 1].length;
    if (lead === null) lead = text.slice(0, from);
    chunks.push({ text: text.slice(from, to), gap: text.slice(lastEnd, from) });
    lastEnd = to;
  }
  if (lead === null) return { lead: '', trail: text, chunks };
  return { lead, trail: text.slice(lastEnd), chunks };
}

/** A typed block when it writes back to exactly `chunk`, else a rawBlock. */
function parseChunk(chunk) {
  const typed = parseTyped(chunk);
  if (typed) {
    try {
      if (serializeBlock(typed) === chunk) return typed;
    } catch {
      // not representable: kept as written
    }
  }
  return { type: 'rawBlock', attrs: { text: chunk } };
}

function parseTyped(chunk) {
  const lines = chunk.split('\n');
  if (/^(```|~~~)/.test(chunk)) return null;
  // an HTML comment that spans lines is markup, not prose: inline parsing works line by line, so keep the whole block as written
  if (/(?<!\\)<!--(?:(?!-->)[\s\S])*\n/.test(chunk)) return null;
  if (lines.length === 1 && chunk === '***') return { type: 'horizontalRule' };
  const h = lines.length === 1 ? /^(#{2,4}) (\S.*)$/.exec(chunk) : null;
  if (h) return { type: 'heading', attrs: { level: h[1].length }, content: parseInline(h[2]) };
  if (lines.every((l) => l.startsWith('> '))) {
    const inner = lines.map((l) => l.slice(2));
    if (inner.some((l) => BLANK.test(l))) return null;
    return { type: 'blockquote', content: [paragraphOf(inner.join('\n'))] };
  }
  const bullet = lines.map((l) => /^([-*+]) (\S.*)$/.exec(l));
  if (bullet.every(Boolean) && bullet.every((m) => m[1] === bullet[0][1])) {
    return { type: 'bulletList', attrs: { marker: bullet[0][1] }, content: bullet.map((m) => ({ type: 'listItem', content: [paragraphOf(m[2])] })) };
  }
  const ordered = lines.map((l) => /^(\d{1,9})([.)]) (\S.*)$/.exec(l));
  if (ordered.every(Boolean) && ordered.every((m, k) => m[2] === ordered[0][2] && Number(m[1]) === Number(ordered[0][1]) + k && String(Number(m[1])) === m[1])) {
    return { type: 'orderedList', attrs: { start: Number(ordered[0][1]), delim: ordered[0][2] }, content: ordered.map((m) => ({ type: 'listItem', content: [paragraphOf(m[3])] })) };
  }
  return paragraphOf(chunk);
}

function paragraphOf(text) {
  const content = [];
  for (const [k, line] of text.split('\n').entries()) {
    if (k > 0) content.push({ type: 'hardBreak', attrs: { soft: true } });
    content.push(...parseInline(line));
  }
  return { type: 'paragraph', content: mergeText(content) };
}

/** One line of inline Markdown -> inline nodes. Anything unmatched stays literal text. */
export function parseInline(line) {
  return mergeText(parseSpan(line, []));
}

function parseSpan(s, marks) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(textNode(buf, marks));
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);
    if (c === '\\' && ESCAPABLE.has(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }
    if (rest.startsWith('<!--')) {
      const j = s.indexOf('-->', i + 4);
      if (j >= 0) {
        flush();
        const full = s.slice(i, j + 3);
        const note = /^<!-- note: ([\s\S]*?) -->$/.exec(full);
        out.push(note && !note[1].includes('-->') && note[1] !== '' ? { type: 'authorNote', attrs: { text: note[1] } } : { type: 'rawInline', attrs: { text: full } });
        i = j + 3;
        continue;
      }
    }
    if (rest.startsWith('![')) {
      const m = /^!\[[^\]\n]*\]\([^)\n]*\)/.exec(rest);
      if (m) {
        flush();
        out.push({ type: 'rawInline', attrs: { text: m[0] } });
        i += m[0].length;
        continue;
      }
    }
    if (rest.startsWith('[[')) {
      const m = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(rest);
      if (m) {
        flush();
        const mention = { type: 'entityMention', attrs: { slug: m[1], form: m[2] === undefined ? 'bare' : 'label', state: 'confirmed' } };
        out.push(textNode(m[2] ?? m[1], [...marks, mention]));
        i += m[0].length;
        continue;
      }
    }
    if (rest.startsWith('[@')) {
      const m = /^\[@([^\]\s]+)\](?!\()/.exec(rest);
      if (m) {
        flush();
        out.push({ type: 'cite', attrs: { key: m[1] } });
        i += m[0].length;
        continue;
      }
    }
    if (c === '[' && !marks.some((m) => m.type === 'link')) {
      const m = /^\[([^\]\n]+)\]\(([^()\s]+)\)/.exec(rest);
      if (m) {
        flush();
        out.push(...parseSpan(m[1], [...marks, { type: 'link', attrs: { href: m[2] } }]));
        i += m[0].length;
        continue;
      }
    }
    if (c === '`') {
      const m = /^`([^`\n]+)`/.exec(rest);
      if (m) {
        flush();
        out.push(textNode(m[1], [...marks, { type: 'code' }]));
        i += m[0].length;
        continue;
      }
    }
    const delim = rest.startsWith('**') ? '**' : rest.startsWith('__') ? '__' : rest.startsWith('~~') ? '~~' : c === '*' || c === '_' ? c : null;
    if (delim) {
      const type = delim === '~~' ? 'strike' : delim.length === 2 ? 'bold' : 'italic';
      const close = findClose(s, i + delim.length, delim);
      const inner = close > 0 ? s.slice(i + delim.length, close) : '';
      const under = delim[0] === '_';
      const ok =
        close > 0 &&
        inner !== '' &&
        !/^\s/.test(inner) &&
        !/\s$/.test(inner) &&
        !marks.some((m) => m.type === type) &&
        (!under || (!isAlnum(s[i - 1]) && !isAlnum(s[close + delim.length])));
      if (ok) {
        flush();
        const mark = type === 'strike' ? { type } : { type, attrs: { delim } };
        out.push(...parseSpan(inner, [...marks, mark]));
        i = close + delim.length;
        continue;
      }
      buf += delim;
      i += delim.length;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Where `delim` closes, skipping escapes, code spans and (for a single delimiter) doubled ones. -1 when it does not. */
function findClose(s, from, delim) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j) j = k;
      continue;
    }
    if (delim.length === 1 && s[j] === delim && s[j + 1] === delim) {
      j++;
      continue;
    }
    if (s.startsWith(delim, j)) {
      // in a longer run ("***" closing "**" around an inner "*"), the outer delimiter is the run's last one
      let r = j;
      if (delim.length === 2 && delim[0] !== '~') while (s[r + 2] === delim[0]) r++;
      return r;
    }
  }
  return -1;
}

const textNode = (text, marks) => (marks.length ? { type: 'text', text, marks: [...marks] } : { type: 'text', text });

function mergeText(nodes) {
  const out = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.type === 'text' && prev?.type === 'text' && stable(prev.marks ?? []) === stable(n.marks ?? [])) prev.text += n.text;
    else out.push(n.type === 'text' ? { ...n } : n);
  }
  return out;
}

function count(node, report) {
  if (node.type === 'doc') report.blocks = node.content.length;
  if (node.type === 'rawBlock') report.rawBlocks++;
  if (node.type === 'rawInline') report.rawInlines++;
  if (node.type === 'authorNote') report.authorNotes++;
  if (node.type === 'cite') report.cites++;
  if (node.type === 'text' && node.marks?.some((m) => m.type === 'entityMention')) report.mentions++;
  for (const c of node.content ?? []) count(c, report);
}

// ----------------------------------------------------------------------------------------------------------------------------- write

/**
 * @param {any} doc a schema v1 document (from markdownToDoc, or edited)
 * @returns {string} the scene body
 * @throws {RichSerializeError} when the result would not read back as the same document
 */
export function docToMarkdown(doc) {
  const d = normalizeDoc(doc);
  let out = d.attrs.lead;
  for (const [i, b] of d.content.entries()) {
    if (i > 0) out += b.attrs.gap;
    out += serializeBlock(b);
  }
  out += d.attrs.trail;
  if (d.attrs.eol === 'crlf') out = out.replaceAll('\n', '\r\n');
  const back = normalizeDoc(markdownToDoc(out).doc);
  if (stable(back) !== stable(d)) throw new RichSerializeError('the scene would not read back the same after saving');
  return out;
}

/** One block. Plain first; with every special character escaped when plain would read back differently; else RichSerializeError. */
function serializeBlock(b) {
  if (b.type === 'rawBlock') return b.attrs.text;
  if (b.type === 'horizontalRule') return '***';
  const want = stable(normalizeBlock(withoutGap(b)));
  for (const tier of ['plain', 'escaped']) {
    const out = writeBlock(b, tier);
    const { lead, trail, chunks } = splitChunks(out);
    if (lead !== '' || trail !== '' || chunks.length !== 1) continue;
    const typed = parseTyped(out);
    if (typed && stable(normalizeBlock(typed)) === want) return out;
  }
  throw new RichSerializeError(`a ${b.type} cannot be written as Markdown without changing it`);
}

function writeBlock(b, tier) {
  const inline = (nodes) => writeInline(nodes ?? [], tier);
  switch (b.type) {
    case 'paragraph':
      return escapeLineStarts(inline(b.content), tier);
    case 'heading':
      return `${'#'.repeat(b.attrs?.level ?? 2)} ${inline(b.content)}`;
    case 'blockquote': {
      const p = b.content?.[0];
      if (b.content?.length !== 1 || p.type !== 'paragraph') throw new RichSerializeError('a quote must hold one paragraph');
      return escapeLineStarts(inline(p.content), tier).split('\n').map((l) => `> ${l}`).join('\n');
    }
    case 'bulletList':
    case 'orderedList': {
      const start = b.attrs?.start ?? 1;
      return (b.content ?? [])
        .map((item, k) => {
          if (item.type !== 'listItem' || item.content?.length !== 1 || item.content[0].type !== 'paragraph') throw new RichSerializeError('a list item must hold one paragraph');
          const text = inline(item.content[0].content);
          if (text.includes('\n')) throw new RichSerializeError('a list item must be one line');
          const marker = b.type === 'bulletList' ? (b.attrs?.marker ?? '-') : `${start + k}${b.attrs?.delim ?? '.'}`;
          return `${marker} ${text}`;
        })
        .join('\n');
    }
    default:
      throw new RichSerializeError(`unknown block ${b.type}`);
  }
}

function escapeLineStarts(text, tier) {
  if (tier !== 'escaped') return text;
  return text
    .split('\n')
    .map((l) => l.replace(/^([#>+-])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2').replace(/^\*\*\*$/, '\\*\\*\\*'))
    .join('\n');
}

function writeInline(nodes, tier) {
  let out = '';
  /** @type {any[]} */
  const open = [];
  const closeTo = (n) => {
    while (open.length > n) out += closer(open.pop());
  };
  const ATOMS = new Set(['authorNote', 'cite', 'rawInline']);
  const has = (node, m) => (node.marks ?? []).some((x) => stable(x) === stable(m));
  /** How many of the following text nodes carry `m` (atoms are transparent, a line break ends the run): longer runs open first, outermost. */
  const runLen = (m, k) => {
    let len = 0;
    for (let j = k; j < nodes.length; j++) {
      if (ATOMS.has(nodes[j].type)) continue;
      if (!has(nodes[j], m)) break;
      len++;
    }
    return len;
  };
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (ATOMS.has(n.type)) {
      // an atom sits inside whatever marks are open around it: the marks are neither closed nor opened for it
      if (n.type === 'authorNote') {
        const t = n.attrs?.text ?? '';
        if (t === '' || t.includes('-->') || t.includes('\n')) throw new RichSerializeError('an author note cannot be empty, hold "-->" or a line break');
        out += `<!-- note: ${t} -->`;
      } else if (n.type === 'cite') out += `[@${n.attrs?.key ?? ''}]`;
      else out += n.attrs?.text ?? '';
      continue;
    }
    const marks = (n.marks ?? []).filter((m) => m.type !== 'entityMention');
    let keep = 0;
    while (keep < open.length && marks.some((m) => stable(m) === stable(open[keep]))) keep++;
    closeTo(keep);
    const fresh = marks.filter((m) => !open.some((o) => stable(o) === stable(m)));
    fresh.sort((a, b) => Number(a.type === 'code') - Number(b.type === 'code') || runLen(b, k) - runLen(a, k) || MARK_RANK[a.type] - MARK_RANK[b.type]);
    for (const m of fresh) {
      out += opener(m);
      open.push(m);
    }
    const inCode = open.some((m) => m.type === 'code');
    const mention = n.marks?.find((m) => m.type === 'entityMention');
    if (n.type === 'text' && mention) {
      // consecutive text with the same mention is one [[...]]
      let label = n.text;
      while (k + 1 < nodes.length && nodes[k + 1].type === 'text' && stable(nodes[k + 1].marks ?? []) === stable(n.marks ?? [])) label += nodes[++k].text;
      out += mentionText(mention, label);
    } else if (n.type === 'text') {
      if (inCode) {
        if (/[`\n]/.test(n.text)) throw new RichSerializeError('code cannot hold a backtick or a line break');
        out += n.text;
      } else out += tier === 'escaped' ? escapeText(n.text) : n.text;
    } else if (n.type === 'hardBreak') {
      closeTo(0);
      out += '\n';
    } else throw new RichSerializeError(`unknown inline ${n.type}`);
  }
  closeTo(0);
  return out;
}

function mentionText(m, label) {
  const a = { ...MARK_DEFAULTS.entityMention, ...m.attrs };
  if (/[\]\n|]/.test(a.slug) || a.slug === '') throw new RichSerializeError('a mention needs a slug without "]", "|" or a line break');
  if (a.form === 'bare' && label === a.slug) return `[[${a.slug}]]`;
  if (/[\]\n]/.test(label) || label === '') throw new RichSerializeError('a mention label cannot hold "]" or a line break');
  return `[[${a.slug}|${label}]]`;
}

function opener(m) {
  if (m.type === 'link') return '[';
  if (m.type === 'strike') return '~~';
  if (m.type === 'code') return '`';
  return m.attrs?.delim ?? MARK_DEFAULTS[m.type].delim;
}
function closer(m) {
  if (m.type === 'link') {
    const href = m.attrs?.href ?? '';
    if (href === '' || /[()\s]/.test(href)) throw new RichSerializeError('a link address cannot be empty or hold spaces or brackets');
    return `](${href})`;
  }
  return opener(m);
}

const escapeText = (t) => [...t].map((c) => (INLINE_SPECIAL.has(c) ? `\\${c}` : c)).join('');

// ------------------------------------------------------------------------------------------------------------------------- compare

/** The document as written: default attrs filled in, empty paragraphs dropped, text merged, gaps made valid. Used on both sides of the stability check. */
export function normalizeDoc(doc) {
  const attrs = { lead: '', trail: '', eol: 'lf', ...(doc?.attrs ?? {}) };
  const content = (doc?.content ?? []).map(normalizeBlock).filter((b) => !(b.type === 'paragraph' && b.content.length === 0));
  content.forEach((b, i) => {
    if (i === 0) delete b.attrs.gap;
    else if (typeof b.attrs.gap !== 'string' || !/^\n([ \t]*\n)+$/.test(b.attrs.gap)) b.attrs.gap = DEFAULT_GAP;
  });
  const out = { type: 'doc', attrs: { lead: attrs.lead, trail: attrs.trail, eol: attrs.eol === 'crlf' ? 'crlf' : 'lf' }, content };
  if (attrs.readOnly) out.attrs.readOnly = true;
  if (content.length === 0) out.attrs = { ...out.attrs, lead: '', trail: attrs.lead + attrs.trail };
  return out;
}

function normalizeBlock(b) {
  const out = { type: b.type, attrs: { ...(NODE_DEFAULTS[b.type] ?? {}), ...pick(b.attrs, b.type) } };
  if (b.attrs?.gap !== undefined) out.attrs.gap = b.attrs.gap;
  if (b.type === 'horizontalRule' || b.type === 'rawBlock') return out;
  const kids = (b.content ?? []).map((c) => (['paragraph', 'listItem', 'blockquote'].includes(c.type) ? normalizeBlock(c) : normalizeInline(c)));
  out.content = mergeText(kids.filter((c) => !(c.type === 'text' && c.text === '')));
  return out;
}

function normalizeInline(n) {
  if (n.type !== 'text') return { type: n.type, attrs: { ...(NODE_DEFAULTS[n.type] ?? {}), ...pick(n.attrs, n.type) } };
  const marks = (n.marks ?? []).map((m) => ({ type: m.type, attrs: { ...(MARK_DEFAULTS[m.type] ?? {}), ...(m.attrs ?? {}) } })).sort((a, b) => (MARK_RANK[a.type] ?? 9) - (MARK_RANK[b.type] ?? 9) || (a.type < b.type ? -1 : 1));
  return marks.length ? { type: 'text', text: n.text, marks } : { type: 'text', text: n.text };
}

/** Only the attrs a node type has (drops gap, which normalizeBlock handles, and editor-only extras). */
function pick(attrs, type) {
  const keys = Object.keys(NODE_DEFAULTS[type] ?? {});
  const out = {};
  for (const k of keys) if (attrs && attrs[k] !== undefined) out[k] = attrs[k];
  return out;
}

const withoutGap = (b) => ({ ...b, attrs: Object.fromEntries(Object.entries(b.attrs ?? {}).filter(([k]) => k !== 'gap')) });

/** JSON with sorted keys, for comparing. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
