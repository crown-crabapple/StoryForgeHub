// moveBookToSeries: put a standalone book into an existing series. Nothing is written until every check has
// passed; then the store's moveTree renames the whole book folder into the series folder in one step, and the
// book's `series_number` is set with a single-line edit of book.md at its new place.
// Every id (book_, scene_, entry_ ...) lives in front matter, so none of them changes; the book's own
// .storyforge folder (journal, trash, revisions, index) moves with it.
import path from 'node:path';
import { moveTree, openStore } from '@storyforge/store';
import { editFrontMatterLine } from '@storyforge/manuscript';

const FIELD_OF = {
  NOT_FOUND: 'bookId',
  ALREADY_IN_SERIES: 'bookId',
  NO_SUCH_SERIES: 'seriesSlug',
  SERIES_NUMBER_TAKEN: 'seriesNumber',
  FOLDER_EXISTS: 'seriesSlug',
  OUTSIDE_ROOT: 'seriesSlug',
};

/** @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
const refuse = (code, message, extra = {}) => ({ ok: false, code, field: FIELD_OF[code] ?? null, message, ...extra });

/**
 * @param {{
 *   root: string,
 *   probe: import('./create-book.mjs').CreateProbe,
 *   bookById: (bookId: string) => Promise<{ id: string, path: string } | null>,
 *   beforeMove: (bookPath: string) => Promise<void>,
 *   afterMove: (oldPath: string, newPath: string, bookId: string, moved: boolean) => Promise<void>,
 * }} deps
 *   `beforeMove` lets go of everything the running app holds open under the book folder (file watches, queued
 *   index work); `afterMove` points the app at the folder's new place (or, when `moved` is false, back at the old one).
 * @returns {(bookId: string, input: any) => Promise<any>}
 */
export function moveBookToSeriesMethod({ root, probe, bookById, beforeMove, afterMove }) {
  return async function moveBookToSeries(bookId, input) {
    const args = input !== null && typeof input === 'object' ? input : {};
    if (typeof bookId !== 'string' || bookId === '') return refuse('NOT_FOUND', 'That book does not exist in this library.');

    if ((await probe.libraryKind()) !== 'library') {
      return refuse('OUTSIDE_ROOT', 'Books can only be moved inside a library folder, not inside a single book or a series folder.', { field: null });
    }
    const book = await bookById(bookId);
    if (!book) return refuse('NOT_FOUND', 'That book does not exist in this library.');
    if (book.path === '' || book.path.includes('/')) return refuse('ALREADY_IN_SERIES', 'Only a standalone book can be moved into a series; this one is already in a series.');

    // ---- series
    if (typeof args.seriesSlug !== 'string' || args.seriesSlug === '') return refuse('NO_SUCH_SERIES', 'Pick the series to move the book into.');
    const series = await probe.findSeries(args.seriesSlug);
    if (!series) return refuse('NO_SUCH_SERIES', 'That series does not exist in this library.');
    if (!series.real) return refuse('OUTSIDE_ROOT', 'That series folder is outside the library folder.');

    // ---- number
    let seriesNumber;
    const n = args.seriesNumber;
    if (n === undefined || n === null || n === '') {
      seriesNumber = Math.max(0, ...series.usedNumbers) + 1;
    } else {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 999_999_999) return refuse('SERIES_NUMBER_TAKEN', 'The series number must be a whole number, 1 or higher.');
      if (series.usedNumbers.includes(n)) return refuse('SERIES_NUMBER_TAKEN', `Book ${n} of that series already exists.`);
      seriesNumber = n;
    }

    // ---- where it goes (the folder keeps its name)
    const oldPath = book.path;
    const newPath = `${series.dir}/${oldPath}`;
    if (await probe.exists(newPath)) return refuse('FOLDER_EXISTS', `The series already has a folder named "${oldPath}".`);

    // ---- move
    let released = false;
    const moved = await moveTree(root, oldPath, newPath, {
      async before() {
        released = true;
        await beforeMove(oldPath);
      },
    });
    if (!moved.ok) {
      if (released) await afterMove(oldPath, oldPath, bookId, false);
      if (moved.code === 'FOLDER_EXISTS') return refuse('FOLDER_EXISTS', `The series already has a folder named "${oldPath}".`);
      if (moved.code === 'OUTSIDE_ROOT') return refuse('OUTSIDE_ROOT', 'That location is outside the library folder.');
      return { ok: false, code: moved.code, field: null, message: moved.message ?? 'The book could not be moved; it is still where it was.' };
    }

    // ---- number, at the new place (the move already happened; a failure here is reported, not undone)
    let numberSet = false;
    let numberMessage;
    try {
      const store = await openStore(path.join(root, ...newPath.split('/')), { recover: false });
      const cur = await store.read('book.md');
      const edit = cur ? editFrontMatterLine(cur.bytes, 'series_number', String(seriesNumber), { integer: true, anchors: ['title', 'slug', 'id'] }) : null;
      if (cur && edit?.ok) {
        const w = edit.changed ? await store.write('book.md', edit.buf, { baseSha256: cur.sha256 }) : { ok: true };
        numberSet = w.ok;
        if (!w.ok) numberMessage = w.message ?? w.code;
      } else {
        numberMessage = edit?.message ?? 'book.md was not found';
      }
    } catch (e) {
      numberMessage = String(/** @type {any} */ (e)?.message ?? e);
    }

    await afterMove(oldPath, newPath, bookId, true);
    return {
      ok: true,
      bookId,
      path: newPath,
      from: oldPath,
      seriesSlug: args.seriesSlug,
      seriesNumber: numberSet ? seriesNumber : null,
      ...(numberSet ? {} : { warning: `The book moved, but its series number could not be set (${numberMessage}). Set it in book.md.` }),
    };
  };
}
