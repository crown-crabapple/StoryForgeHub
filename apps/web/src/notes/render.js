// How a note's Markdown links are shown (M04-J04). Pure. The rules: an http(s) link is external (opens in a new tab, rel="noopener noreferrer", shown with an
// external-link icon and its host name; nothing is ever fetched); a relative link that lands on a file under assets/ is an attachment (it opens the attachment
// route); every other target (another scheme, an absolute local path, a path outside assets/) is shown as plain text and never becomes a link.

const enc = encodeURIComponent;
const ATTACHMENT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'csv'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const INLINE_RE = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)|\[@([^\]\s]+)\](?!\()/g;

/** The URL a book-relative `assets/...` path is served from. @param {string} bookId @param {string} rel */
export const attachmentUrl = (bookId, rel) => `/api/books/${enc(bookId)}/attachments?path=${enc(rel)}`;

/** The folder of a book-relative file path ('' for the book root). @param {string} rel */
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/** Normalise `a/b/../c` without leaving the root: null when it climbs out. @param {string} p */
function normalise(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

/**
 * What a link target is. `notePath` is the note's book-relative path (links are relative to the file that holds them).
 * @param {string} raw the text between the parentheses @param {string} notePath @param {string} bookId
 * @returns {{ kind: 'external', url: string, host: string } | { kind: 'attachment', path: string, url: string, image: boolean } | { kind: 'none' }}
 */
export function classifyHref(raw, notePath, bookId) {
  let t = raw.trim();
  if (t.startsWith('<')) {
    const end = t.indexOf('>');
    t = end > 0 ? t.slice(1, end) : t.slice(1);
  } else t = t.split(/\s+/)[0];
  if (t === '') return { kind: 'none' };
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '') return { kind: 'external', url: u.href, host: u.hostname.replace(/^www\./, '') };
    } catch {
      // not a URL
    }
    return { kind: 'none' };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(t) || t.startsWith('/') || t.startsWith('\\') || t.startsWith('#')) return { kind: 'none' };
  let path = t.split('#')[0].split('?')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep as written
  }
  const base = dirOf(notePath);
  const resolved = normalise(base === '' ? path : `${base}/${path}`);
  if (resolved === null || !resolved.startsWith('assets/')) return { kind: 'none' };
  const ext = resolved.slice(resolved.lastIndexOf('.') + 1).toLowerCase();
  if (!ATTACHMENT_EXTENSIONS.includes(ext)) return { kind: 'none' };
  return { kind: 'attachment', path: resolved, url: attachmentUrl(bookId, resolved), image: IMAGE_EXTENSIONS.includes(ext) };
}

/**
 * Split a run of text into text, link, image and citation parts: [{ type: 'text', text } | { type: 'link' | 'image', label, target } | { type: 'cite', key }], where
 * `target` is classifyHref()'s answer. Joining the `raw` of every part gives the text back.
 * @param {string} text @param {string} notePath @param {string} bookId
 */
export function inlineParts(text, notePath, bookId) {
  const out = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(text); m !== null; m = INLINE_RE.exec(text)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index), raw: text.slice(last, m.index) });
    if (m[4] !== undefined) out.push({ type: 'cite', key: m[4], raw: m[0] });
    else out.push({ type: m[1] === '!' ? 'image' : 'link', label: m[2], target: classifyHref(m[3], notePath, bookId), raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last), raw: text.slice(last) });
  return out;
}
