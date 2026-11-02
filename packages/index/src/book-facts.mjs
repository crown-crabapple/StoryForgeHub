// The display facts of a book that the library page needs (M02-J02): one pure function, used by the index
// build (to fill index meta) and by the file-reading path of the repository, so both give the same values.

const str = (v) => (typeof v === 'string' ? v : null);
const MAX_BLURB = 280;

/** Plain text of a Markdown paragraph: links, emphasis, code marks and comments removed, whitespace collapsed. */
function plain(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * First paragraph of a book.md body as plain text, at most 280 characters (cut with an ellipsis).
 * Paragraphs that are only headings are skipped. '' when there is none.
 * @param {string} body
 */
export function blurbOf(body) {
  for (const para of String(body ?? '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    const lines = para.split('\n').filter((l) => l.trim() !== '' && !/^\s{0,3}#{1,6}(\s|$)/.test(l));
    const text = plain(lines.join('\n'));
    if (text === '') continue;
    const chars = Array.from(text);
    return chars.length <= MAX_BLURB ? text : `${chars.slice(0, MAX_BLURB - 1).join('').trimEnd()}…`;
  }
  return '';
}

/**
 * @param {{ fm: Record<string, any>, body: string, seriesFm: Record<string, any> | null, libraryFm: Record<string, any> | null }} p
 *   `seriesFm`: front matter of the book's series.md (null for a standalone book); `libraryFm`: of library.md.
 * @returns {{ subtitle: string | null, pen_name: string | null, pen_name_display: string | null, genre: string[],
 *   word_target: number | null, language: string | null, series_title: string | null, archived: boolean,
 *   cover_color: string | null, cover: string | null, blurb: string }}
 *   `cover` is the raw `cover` field; what it resolves to (cover_state, cover_url) is decided on read.
 */
export function bookFacts({ fm, body, seriesFm, libraryFm }) {
  const penName = str(fm.pen_name);
  const penNames = Array.isArray(libraryFm?.pen_names) ? libraryFm.pen_names : [];
  const pen = penName === null ? null : penNames.find((p) => p && typeof p === 'object' && p.slug === penName);
  const color = str(fm.cover_color);
  return {
    subtitle: str(fm.subtitle),
    pen_name: penName,
    pen_name_display: pen ? str(pen.name) : null,
    genre: Array.isArray(fm.genre) ? fm.genre.filter((g) => typeof g === 'string') : [],
    word_target: typeof fm.word_target === 'number' && Number.isInteger(fm.word_target) ? fm.word_target : null,
    language: str(fm.language),
    series_title: seriesFm ? str(seriesFm.title) : null,
    archived: str(fm.status) === 'archived',
    cover_color: color !== null && /^#[0-9A-Fa-f]{6}$/.test(color) ? color : null,
    cover: str(fm.cover),
    blurb: blurbOf(body),
  };
}
