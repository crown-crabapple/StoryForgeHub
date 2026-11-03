// createBook: validate everything first (nothing is written until every check has passed), then hand the
// rendered template to the store's createTree, which stages, validates and renames it into place in one step.
// No filesystem access here: reads come through the `probe` the FsRepository passes in, writes through @storyforge/store.
import { createTree, escapesRoot } from '@storyforge/store';
import { SLUG_RE, slugify } from '@storyforge/manuscript';
import { listTemplates, renderTemplate } from '@storyforge/templates';

/** Control characters, and the two Unicode line separators, which YAML would also treat as line breaks. */
const hasControl = (text) => [...text].some((ch) => {
  const c = /** @type {number} */ (ch.codePointAt(0));
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
});
const FIELD_OF = {
  BAD_TITLE: 'title',
  BAD_SLUG: 'slug',
  SLUG_TAKEN: 'slug',
  FOLDER_EXISTS: 'slug',
  NO_SUCH_SERIES: 'seriesSlug',
  SERIES_NUMBER_TAKEN: 'seriesNumber',
  NO_SUCH_PEN_NAME: 'penName',
  NO_SUCH_TEMPLATE: 'template',
  OUTSIDE_ROOT: 'slug',
};

/** @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
const refuse = (code, message, extra = {}) => ({ ok: false, code, field: FIELD_OF[code] ?? null, message, ...extra });

/**
 * @typedef {{
 *   libraryKind(): Promise<'library' | 'book' | 'series'>,
 *   bookSlugs(): Promise<string[]>,
 *   penNameSlugs(): Promise<string[]>,
 *   findSeries(seriesSlug: string): Promise<{ dir: string, usedNumbers: number[], real: boolean } | null>,
 *   exists(relDir: string): Promise<boolean>,
 * }} CreateProbe
 *   `findSeries` returns the series folder (library-relative), the `series_number`s its books use, and whether
 *   the folder really lies inside the library (false for a link that leads elsewhere).
 */

/**
 * @param {{ root: string, probe: CreateProbe, afterCreate: (bookPath: string, bookId?: string) => Promise<void> }} deps
 * @returns {(input: any) => Promise<any>}
 */
export function createBookMethod({ root, probe, afterCreate }) {
  return async function createBook(input) {
    const args = input !== null && typeof input === 'object' ? input : {};

    // ---- title
    if (typeof args.title !== 'string') return refuse('BAD_TITLE', 'Give the book a title.');
    const title = args.title.trim();
    if (title.length < 1) return refuse('BAD_TITLE', 'Give the book a title.');
    if (title.length > 120) return refuse('BAD_TITLE', 'The title can be at most 120 characters.');
    if (hasControl(title)) return refuse('BAD_TITLE', 'The title cannot contain line breaks or other control characters.');

    // ---- slug
    const slug = args.slug === undefined || args.slug === null ? slugify(title) : args.slug;
    if (typeof slug !== 'string' || slug.length < 1 || slug.length > 60 || !SLUG_RE.test(slug)) {
      return refuse(
        'BAD_SLUG',
        args.slug === undefined || args.slug === null
          ? 'The title has no letters or digits to make a folder name from; type a folder name.'
          : 'The folder name can use only lower-case letters a-z, digits and single hyphens (1 to 60 characters).',
      );
    }
    if ((await probe.libraryKind()) !== 'library') {
      return refuse('OUTSIDE_ROOT', 'New books can only be created in a library folder, not inside a single book or a series folder.', { field: null });
    }
    if ((await probe.bookSlugs()).includes(slug)) return refuse('SLUG_TAKEN', `Another book already uses the name "${slug}".`);

    // ---- series
    let series = null;
    if (args.seriesSlug !== undefined && args.seriesSlug !== null && args.seriesSlug !== '') {
      series = typeof args.seriesSlug === 'string' ? await probe.findSeries(args.seriesSlug) : null;
      if (!series) return refuse('NO_SUCH_SERIES', 'That series does not exist in this library.');
    }
    const relDir = series ? `${series.dir}/${slug}` : slug;
    let seriesNumber;
    if (series) {
      const n = args.seriesNumber;
      if (n === undefined || n === null || n === '') {
        seriesNumber = Math.max(0, ...series.usedNumbers) + 1;
      } else {
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return refuse('SERIES_NUMBER_TAKEN', 'The series number must be a whole number, 1 or higher.');
        if (series.usedNumbers.includes(n)) return refuse('SERIES_NUMBER_TAKEN', `Book ${n} of that series already exists.`);
        seriesNumber = n;
      }
    }

    // ---- pen name
    let penName;
    if (args.penName !== undefined && args.penName !== null && args.penName !== '') {
      if (typeof args.penName !== 'string' || !(await probe.penNameSlugs()).includes(args.penName)) {
        return refuse('NO_SUCH_PEN_NAME', 'That pen name is not listed in this library.');
      }
      penName = args.penName;
    }

    // ---- template
    // a template is picked by name, and by `templateSource` ('builtin' | 'library') when a library template shares a built-in's name (M07-J01)
    const known = await listTemplates({ libraryRoot: root });
    const source = args.templateSource === 'library' || args.templateSource === 'builtin' ? args.templateSource : undefined;
    const picked = typeof args.template === 'string' ? known.find((t) => t.name === args.template && (source === undefined ? t.source === 'builtin' : t.source === source)) ?? (source === undefined ? known.find((t) => t.name === args.template) : undefined) : undefined;
    if (!picked) return refuse('NO_SUCH_TEMPLATE', 'Pick one of the templates on offer.');

    // ---- where it goes
    if ((series && !series.real) || (await escapesRoot(root, relDir))) {
      return refuse('OUTSIDE_ROOT', 'That location is outside the library folder.');
    }
    if (await probe.exists(relDir)) return refuse('FOLDER_EXISTS', `A folder named "${slug}" already exists there.`);

    // ---- write
    const files = await renderTemplate(picked.name, { book_title: title, book_slug: slug, pen_name: penName, series_number: seriesNumber }, { libraryRoot: root, source: picked.source });
    const made = await createTree(root, relDir, files);
    if (!made.ok) {
      if (made.code === 'FOLDER_EXISTS') return refuse('FOLDER_EXISTS', `A folder named "${slug}" already exists there.`);
      if (made.code === 'OUTSIDE_ROOT') return refuse('OUTSIDE_ROOT', 'That location is outside the library folder.');
      return {
        ok: false,
        code: made.code,
        field: null,
        message: made.message ?? (made.code === 'TEMPLATE_INVALID' ? 'The template did not produce a valid book, so nothing was created.' : 'The book could not be created.'),
        ...(made.diagnostics ? { diagnostics: made.diagnostics } : {}),
      };
    }
    const bookId = /^id: (book_[0-9A-HJKMNP-TV-Z]{26})$/m.exec(/** @type {Buffer} */ (files.get('book.md')).toString('utf8'))?.[1];
    await afterCreate(relDir, bookId);
    return { ok: true, bookId, path: relDir };
  };
}
