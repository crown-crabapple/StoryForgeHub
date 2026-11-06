// Continuity exceptions (M05-J02): create / archive `planning/continuity/<slug>.md` and read context lines for the review queue.
// Everything is written through @storyforge/store (atomic, journaled, a trash copy for Undo). Nothing else is ever written here,
// and prose, Codex entries and events are never touched.
import path from 'node:path';
import { checkContinuity } from '@storyforge/continuity';
import { extractDocs, validate } from '@storyforge/format';
import { slugify, ulid } from '@storyforge/manuscript';
import { openStore } from '@storyforge/store';
import { localDate } from './writing-log.mjs';

const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f]`);
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const DIR = 'planning/continuity';
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', '~']);
/** One line of text as a YAML value: plain when that is safe, else a double-quoted string (JSON escapes are valid YAML). */
const yamlText = (v) => (/^[A-Za-z][A-Za-z0-9 .,'()_-]*$/.test(v) && v === v.trim() && !RESERVED.has(v.toLowerCase()) ? v : JSON.stringify(v));
const errKey = (d) => `${d.code}|${d.file}|${d.location ?? ''}`;

/**
 * @param {{ root: string, afterWrite?: (bookPath: string) => void, reconcile?: (bookPath: string) => Promise<any>, now?: () => number }} p
 */
export function createContinuityExceptionMethods({ root, afterWrite = () => {}, reconcile, now = () => Date.now() }) {
  const bookRootOf = (book) => (book.path === '' ? root : path.join(root, ...book.path.split('/')));

  async function findBook(bookId) {
    const result = await validate(root);
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    return book ? { book, result } : null;
  }

  /** Run one batch (create or archive); the store undoes it if the library gained a validation error. */
  async function run(found, store, op, args, fn) {
    const { book, result } = found;
    const known = new Set(result.diagnostics.filter((d) => d.severity === 'error').map(errKey));
    const r = await store.batch(op, args, fn, {
      verify: async () => {
        const after = (await validate(root)).diagnostics;
        const fresh = after.filter((d) => d.severity === 'error' && !known.has(errKey(d)));
        if (fresh.length) {
          const err = new Error('the change would introduce new errors');
          /** @type {any} */ (err).diagnostics = fresh;
          throw err;
        }
      },
    });
    if (r.ok) {
      if (reconcile) await reconcile(book.path);
      else afterWrite(book.path);
      return r;
    }
    if (r.code === 'ROLLED_BACK') return fail('ROLLED_BACK', { message: r.message, diagnostics: r.diagnostics ?? [] });
    if (r.code === 'EXISTS') return fail('REFUSED_PATH_TAKEN', { message: 'a file with that name is already there' });
    return fail(r.code, r.message ? { message: r.message } : {});
  }

  /**
   * Acknowledge one finding: write planning/continuity/<slug>.md. Refusals write nothing: FINDING_NOT_FOUND, ALREADY_EXCEPTED, RATIONALE_REQUIRED, BAD_ARGS.
   * @param {string} bookId @param {{ fingerprint?: string, rationale?: string, title?: string, intentional?: boolean, dryRun?: boolean }} args
   */
  async function createContinuityException(bookId, args = {}) {
    const { fingerprint, rationale, title: given, intentional, dryRun = false } = args ?? {};
    if (typeof fingerprint !== 'string' || fingerprint === '') return fail('BAD_ARGS', { message: 'fingerprint must be a string' });
    if (typeof rationale !== 'string' || rationale.trim() === '') return fail('RATIONALE_REQUIRED', { message: 'write why this is fine (the rationale is required)' });
    if (given !== undefined && given !== null && (typeof given !== 'string' || CONTROL_RE.test(given) || given.length > 300)) return fail('BAD_ARGS', { message: 'title must be one line of text (max 300)' });
    if (intentional !== undefined && intentional !== null && typeof intentional !== 'boolean') return fail('BAD_ARGS', { message: 'intentional must be true or false' });
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const bookRoot = bookRootOf(found.book);
    const continuity = await checkContinuity(bookRoot);
    const finding = continuity.findings.find((f) => f.fingerprint === fingerprint);
    if (!finding) {
      if (continuity.suppressed.some((s) => s.finding.fingerprint === fingerprint)) return fail('ALREADY_EXCEPTED', { message: 'this finding already has an exception' });
      return fail('FINDING_NOT_FOUND', { message: 'no current finding has that fingerprint' });
    }
    const title = typeof given === 'string' && given.trim() !== '' ? given.trim() : finding.title;
    const store = await openStore(bookRoot);
    const taken = new Set(extractDocs(found.result, found.book.path).filter((d) => d.kind === 'continuity-exception').map((d) => String(d.fm.slug ?? '')));
    const base = slugify(title).slice(0, 56).replace(/-+$/g, '') || 'exception';
    let slug = base;
    for (let n = 2; ; n++) {
      const busy = taken.has(slug) || (await store.exists(`${DIR}/${slug}.md`)) || (await store.exists(`archive/${DIR}/${slug}.md`));
      if (!busy) break;
      slug = `${base}-${n}`;
    }
    const file = `${DIR}/${slug}.md`;
    const id = `note_${ulid()}`;
    const text = `---\nschema: storyforge.continuity-exception/v1\nid: ${id}\nslug: ${slug}\nfingerprint: ${fingerprint}\nrule: ${finding.rule}\ntitle: ${yamlText(title)}\ncreated: "${localDate(new Date(Number(now())))}"\n${intentional === true ? 'intentional: true\n' : ''}---\n${rationale.trim()}\n`;
    if (dryRun) return { ok: true, code: 'OK', dryRun: true, file, slug, id, text, changes: [{ from: null, to: file }] };
    const bytes = Buffer.from(text, 'utf8');
    const r = await run(found, store, 'createContinuityException', { fingerprint, file }, (tx) => tx.create(file, bytes));
    if (!r.ok) return r;
    // Undo = restoreOp(opId): for this one operation it removes the new file again (to the trash), leaving the tree as it was.
    return { ok: true, code: 'OK', file, slug, id, opId: r.opId, undo: { op: r.opId } };
  }

  /**
   * Archive one exception (never a hard delete) so its finding comes back. `slug` is the exception's front-matter slug. Missing: NOT_FOUND.
   * @param {string} bookId @param {string} slug @param {{ dryRun?: boolean }} args
   */
  async function archiveContinuityException(bookId, slug, args = {}) {
    const { dryRun = false } = args ?? {};
    const found = await findBook(bookId);
    if (!found || typeof slug !== 'string' || slug === '') return fail('NOT_FOUND');
    const doc = extractDocs(found.result, found.book.path).find((d) => d.kind === 'continuity-exception' && !d.archived && d.fm.slug === slug);
    if (!doc) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book));
    const cur = await store.read(doc.rel);
    if (!cur) return fail('NOT_FOUND');
    const archived = `archive/${doc.rel}`;
    if (dryRun) return { ok: true, code: 'OK', dryRun: true, archived, slug, changes: [{ from: doc.rel, to: archived }] };
    const r = await run(found, store, 'archiveContinuityException', { slug, file: doc.rel }, (tx) => tx.archive(doc.rel, { baseSha256: cur.sha256 }));
    if (!r.ok) return r;
    return { ok: true, code: 'OK', archived, slug, opId: r.opId, undo: { op: r.opId } };
  }

  /**
   * The lines around one line of a canonical book file (for "Show both"). Refusals: BAD_PATH (escape, `.storyforge/`, not a Markdown file), BAD_ARGS (line, radius over 10), NOT_FOUND.
   * @param {string} bookId @param {{ file?: unknown, line?: unknown, radius?: unknown }} args
   */
  async function getContinuityContext(bookId, args = {}) {
    const { file, line, radius = 3 } = args ?? {};
    if (typeof file !== 'string' || file === '' || file.includes('\\') || file.includes('\0') || file.startsWith('/') || /^[A-Za-z]:/.test(file)) return fail('BAD_PATH', { message: 'file must be a book-relative path' });
    const segments = file.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..' || s === '.storyforge') || !/\.md$/i.test(file)) return fail('BAD_PATH', { message: 'file must be a Markdown file of the book' });
    if (!Number.isInteger(line) || /** @type {number} */ (line) < 1) return fail('BAD_ARGS', { message: 'line must be an integer from 1' });
    if (!Number.isInteger(radius) || /** @type {number} */ (radius) < 0 || /** @type {number} */ (radius) > 10) return fail('BAD_ARGS', { message: 'radius must be an integer from 0 to 10' });
    const at = /** @type {number} */ (line);
    const r = /** @type {number} */ (radius);
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book));
    const got = await store.read(file);
    if (!got) return fail('NOT_FOUND');
    const all = got.bytes.toString('utf8').split('\n').map((t) => t.replace(/\r$/, ''));
    const from = Math.max(1, at - r);
    const to = Math.min(all.length, at + r);
    const lines = [];
    for (let n = from; n <= to; n++) lines.push({ n, text: all[n - 1] });
    return { ok: true, code: 'OK', lines };
  }

  return { createContinuityException, archiveContinuityException, getContinuityContext };
}
