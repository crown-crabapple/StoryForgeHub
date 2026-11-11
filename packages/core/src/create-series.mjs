// createSeries: validate everything first, then hand a one-file folder (series.md) to the store's createTree.
// createTree validates the staged folder with @storyforge/format; a series-only folder passes with zero diagnostics.
// No filesystem access here: reads come through the `probe` the FsRepository passes in, writes through @storyforge/store.
import { createTree, escapesRoot } from '@storyforge/store';
import { SLUG_RE, slugify, ulid } from '@storyforge/manuscript';

/** Control characters, and the two Unicode line separators, which YAML would also treat as line breaks. */
const hasControl = (text) => [...text].some((ch) => {
  const c = /** @type {number} */ (ch.codePointAt(0));
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
});

export const SERIES_STATUSES = ['planned', 'active', 'complete', 'archived'];

/**
 * The same title rules createBook uses: trimmed, 1 to 120 characters, no control characters.
 * @param {unknown} raw @param {string} [what]
 * @returns {{ ok: true, title: string } | { ok: false, code: 'BAD_TITLE', field: 'title', message: string }}
 */
export function checkTitle(raw, what = 'book') {
  const bad = (message) => ({ ok: false, code: /** @type {const} */ ('BAD_TITLE'), field: /** @type {const} */ ('title'), message });
  if (typeof raw !== 'string') return bad(`Give the ${what} a title.`);
  const title = raw.trim();
  if (title.length < 1) return bad(`Give the ${what} a title.`);
  if (title.length > 120) return bad('The title can be at most 120 characters.');
  if (hasControl(title)) return bad('The title cannot contain line breaks or other control characters.');
  return { ok: true, title };
}

const FIELD_OF = {
  BAD_TITLE: 'title',
  BAD_SLUG: 'slug',
  BAD_STATUS: 'status',
  SLUG_TAKEN: 'slug',
  FOLDER_EXISTS: 'slug',
  OUTSIDE_ROOT: 'slug',
};

/** @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
const refuse = (code, message, extra = {}) => ({ ok: false, code, field: FIELD_OF[code] ?? null, message, ...extra });

/** YAML double-quoted scalar for a title (JSON string syntax is valid YAML). */
const quote = (s) => JSON.stringify(s);

/**
 * @param {{
 *   root: string,
 *   probe: { libraryKind(): Promise<string>, bookSlugs(): Promise<string[]>, seriesSlugs(): Promise<string[]>, exists(relDir: string): Promise<boolean> },
 *   afterCreate: (seriesPath: string) => Promise<void>,
 * }} deps
 * @returns {(input: any) => Promise<any>}
 */
export function createSeriesMethod({ root, probe, afterCreate }) {
  return async function createSeries(input) {
    const args = input !== null && typeof input === 'object' ? input : {};

    const t = checkTitle(args.title, 'series');
    if (!t.ok) return refuse(t.code, t.message);
    const title = t.title;

    const slug = args.slug === undefined || args.slug === null || args.slug === '' ? slugify(title) : args.slug;
    if (typeof slug !== 'string' || slug.length < 1 || slug.length > 60 || !SLUG_RE.test(slug)) {
      return refuse(
        'BAD_SLUG',
        args.slug === undefined || args.slug === null || args.slug === ''
          ? 'The title has no letters or digits to make a folder name from; type a folder name.'
          : 'The folder name can use only lower-case letters a-z, digits and single hyphens (1 to 60 characters).',
      );
    }

    const status = args.status === undefined || args.status === null || args.status === '' ? 'active' : args.status;
    if (typeof status !== 'string' || !SERIES_STATUSES.includes(status)) {
      return refuse('BAD_STATUS', `The status must be one of ${SERIES_STATUSES.join(', ')}.`);
    }

    if ((await probe.libraryKind()) !== 'library') {
      return refuse('OUTSIDE_ROOT', 'New series can only be created in a library folder, not inside a single book or a series folder.', { field: null });
    }
    if ((await probe.bookSlugs()).includes(slug) || (await probe.seriesSlugs()).includes(slug)) {
      return refuse('SLUG_TAKEN', `Another book or series already uses the name "${slug}".`);
    }
    if (await escapesRoot(root, slug)) return refuse('OUTSIDE_ROOT', 'That location is outside the library folder.');
    if (await probe.exists(slug)) return refuse('FOLDER_EXISTS', `A folder named "${slug}" already exists.`);

    const seriesId = `series_${ulid()}`;
    const text = `---\nschema: storyforge.series/v1\nid: ${seriesId}\nslug: ${slug}\ntitle: ${quote(title)}\nstatus: ${status}\n---\n\n`;
    const made = await createTree(root, slug, new Map([['series.md', Buffer.from(text, 'utf8')]]));
    if (!made.ok) {
      if (made.code === 'FOLDER_EXISTS') return refuse('FOLDER_EXISTS', `A folder named "${slug}" already exists.`);
      if (made.code === 'OUTSIDE_ROOT') return refuse('OUTSIDE_ROOT', 'That location is outside the library folder.');
      return {
        ok: false,
        code: made.code,
        field: null,
        message: made.message ?? 'The series could not be created.',
        ...(made.diagnostics ? { diagnostics: made.diagnostics } : {}),
      };
    }
    await afterCreate(slug);
    return { ok: true, seriesId, slug, path: slug };
  };
}
