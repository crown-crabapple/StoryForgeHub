// Loading a book through @storyforge/format and the rule-5 / rule-6 error checks.
import path from 'node:path';
import { validate } from '@storyforge/format';

/**
 * @param {string} bookRoot
 * @returns {Promise<{root:string, diagnostics:object[], book:any} | {error:{code:string, message:string}}>}
 */
export async function loadBook(bookRoot) {
  if (typeof bookRoot !== 'string' || bookRoot === '') {
    return { error: { code: 'REFUSED_NOT_A_BOOK', message: 'bookRoot must be a path' } };
  }
  const root = path.resolve(bookRoot);
  let result;
  try {
    result = await validate(root);
  } catch (e) {
    return { error: { code: 'REFUSED_NOT_A_BOOK', message: String(e?.message ?? e) } };
  }
  if (result.books.length !== 1 || result.books[0].path !== '') {
    return { error: { code: 'REFUSED_NOT_A_BOOK', message: `${bookRoot} is not a single book root (book.md missing)` } };
  }
  return { root, diagnostics: result.diagnostics, book: result.books[0] };
}

/** Rule 5: errors E1xx/E2xx on files under manuscript/ (optionally excluding some codes). */
export function manuscriptErrors(diagnostics, allowCodes = []) {
  return diagnostics.filter(
    (d) =>
      d.severity === 'error' &&
      /^E[12]\d\d$/.test(d.code) &&
      d.file.startsWith('manuscript/') &&
      !allowCodes.includes(d.code),
  );
}

export const errorKey = (d) => `${d.code}\0${d.file}\0${d.location}`;

/** Errors present in `after` that were not in `before` (rule 6). */
export function newErrors(before, after) {
  const known = new Set(before.filter((d) => d.severity === 'error').map(errorKey));
  return after.filter((d) => d.severity === 'error' && !known.has(errorKey(d)));
}
